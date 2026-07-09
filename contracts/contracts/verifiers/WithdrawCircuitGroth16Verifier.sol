// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract WithdrawCircuitGroth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 6365629151808674834238551165822809316881822105607877594772757631863626271626;
    uint256 constant deltax2 = 10502990515217544342118356305787327289487090382159357308192046985282700433537;
    uint256 constant deltay1 = 16296282108730264786689244167133226886045646365998505844214714009393324241930;
    uint256 constant deltay2 = 5193771817201331970431924534162485944723999467836998069436812875327734510233;

    
    uint256 constant IC0x = 11668030768982174988315578800515098268095958336328620786726427170889418741301;
    uint256 constant IC0y = 12830128751532076647154044575439533260884816271528132751378948213598797056659;
    
    uint256 constant IC1x = 122553302691155487971695272446778073436405101025840723275402329359390195354;
    uint256 constant IC1y = 20406127155715319057309683179282528477509489482001054804640976841555607842541;
    
    uint256 constant IC2x = 10893636774628876142899763192646905724708189468282917758613650147010478133301;
    uint256 constant IC2y = 148896310776292842756025446759984436974180847194558332931999839598427070960;
    
    uint256 constant IC3x = 15550575461234686720063491014368064382464483659875934656158426803714221382565;
    uint256 constant IC3y = 19120379509284667271969003793820599158352811626916363073794854942946766897866;
    
    uint256 constant IC4x = 11997276881897936472837561222757310995977345728486444480476752931527806516438;
    uint256 constant IC4y = 737024421379298120335516868702549484509013191532965487105618647991650298484;
    
    uint256 constant IC5x = 19677974929815656195387967292048914984373675040193074047636585472049442720491;
    uint256 constant IC5y = 10141508255865662035934756555228488100770997341006900106739896716315583398755;
    
    uint256 constant IC6x = 17729740485077231525915005240789252003871266035358118446803131706576150070834;
    uint256 constant IC6y = 21463211066327337387171909090874947331633898607474204358116806224285045707724;
    
    uint256 constant IC7x = 2541364605460121444367617049274470896879571465893010763118465395946894872402;
    uint256 constant IC7y = 15666472859923637808751528199087900998876037477297252503877624663975157070339;
    
    uint256 constant IC8x = 19412597310563204613184634003034326013515621831694714651927930505680641506032;
    uint256 constant IC8y = 7090834739055515275081335901169439667521190970728112165903260270557944931447;
    
    uint256 constant IC9x = 687622791121058684572490068566579804627881043520672621913250421784418936468;
    uint256 constant IC9y = 12438570622645808676528087047069161296724662341925122787880168407993098364378;
    
    uint256 constant IC10x = 2256336126216590424153819634776022210916631465813758319833132994414000265810;
    uint256 constant IC10y = 14871133877320414522348861289280860819407005829851620950752250168049105134244;
    
    uint256 constant IC11x = 5268036746963758940162316014618837296844723451466645707274717691934126976172;
    uint256 constant IC11y = 14043587525208299419769690167114748602978120733028534419518881521020011459176;
    
    uint256 constant IC12x = 2154876666208174266715465795960362078373910330071013833946880236172287268609;
    uint256 constant IC12y = 21039580639663636314965780229016132769762902314737515280504608091159095741241;
    
    uint256 constant IC13x = 16336909857979898535516215802114635770223252233010396112078559223843933803808;
    uint256 constant IC13y = 7004567302322641279975389394870214367266003425057422009964578684235048564110;
    
    uint256 constant IC14x = 7510101589966203229059356316761275261569766791979628349139748348788399588502;
    uint256 constant IC14y = 6787100935552764653462602515138571334407597634374519037897835434137613528973;
    
    uint256 constant IC15x = 15839334625619375482935791705322004043072260453789756012451905370323543014491;
    uint256 constant IC15y = 21752850639855585991626846970887014669858240281956242791436741246893327062812;
    
    uint256 constant IC16x = 8486962044828549404108781901934570149077571365702200623962117478945962708012;
    uint256 constant IC16y = 5177923901509395134163622097195381342319188207383408808200785221500245384712;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[16] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
